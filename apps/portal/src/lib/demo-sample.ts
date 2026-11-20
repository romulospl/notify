import type { ApiCounts, ApiServiceDashboard } from "./data/api-metrics";
import type { ProjectApiStats } from "./data/operator/api";
import type { Period, PeriodUnit } from "./period";
import type { ProjectWebStats } from "./umami/overview";
import type { SiteDashboard, Totals } from "./umami/stats";

// Sample data for the public demo when no demo tenant is configured
// (DEMO_TENANT_SLUG empty). Everything here is made up: a fictional "Stellytics"
// project with one website and one API service. Nothing is read from the
// database or from Umami, and the pages that use it say on screen that the
// numbers are illustrative.
//
// Values are derived from each bucket's timestamp, so a reload shows the same
// chart and the totals always match the series.

export const SAMPLE_PROJECT = { id: "sample", name: "Stellytics", slug: "stellytics" } as const;
export const SAMPLE_SITE = { id: "sample-site", name: "Stellytics", domain: "stellytics.xyz" } as const;
export const SAMPLE_SERVICE = { id: "sample-service", name: "Stellytics API" } as const;

// Deterministic value in [0, 1) from an integer.
function noise(seed: number): number {
  let x = (seed ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

// Size of one bucket relative to a day, with a weekly and a daily rhythm.
function weight(unit: PeriodUnit, at: Date, salt: number): number {
  const jitter = 0.8 + 0.4 * noise(Math.floor(at.getTime() / 60_000) + salt);
  if (unit === "month") return 30 * jitter;
  const weekend = at.getUTCDay() === 0 || at.getUTCDay() === 6 ? 0.6 : 1;
  if (unit === "day") return weekend * jitter;
  const hour = at.getUTCHours();
  const daytime = 0.35 + 0.65 * Math.max(0, Math.sin(((hour - 6) / 24) * 2 * Math.PI));
  return (weekend * daytime * jitter) / 14;
}

// The last bucket is still open: it only has part of its traffic.
const open = (period: Period, i: number) => (i === period.buckets.length - 1 ? 0.55 : 1);

function split(total: number, shares: readonly (readonly [string, number])[]): { name: string; value: number }[] {
  return shares.map(([name, share]) => ({ name, value: Math.round(total * share) })).filter((item) => item.value > 0);
}

const DAILY_PAGEVIEWS = 240;

function webTotals(pageviews: number, visitors: number): Totals {
  const visits = Math.round(visitors * 1.18);
  return { pageviews, visitors, visits, bounces: Math.round(visits * 0.44), totaltime: visits * 96 };
}

export function sampleSiteDashboard(period: Period): SiteDashboard {
  const series = period.buckets.map((at, i) => {
    const pageviews = Math.round(DAILY_PAGEVIEWS * weight(period.unit, at, 1) * open(period, i));
    return { at, pageviews, visitors: Math.round(pageviews * 0.41) };
  });
  const pageviews = series.reduce((sum, p) => sum + p.pageviews, 0);
  const visitors = series.reduce((sum, p) => sum + p.visitors, 0);
  const ranked = (shares: readonly (readonly [string, number])[]) =>
    split(visitors, shares).map((item) => ({ name: item.name, visitors: item.value }));
  const counted = (total: number, shares: readonly (readonly [string, number])[]) =>
    split(total, shares).map((item) => ({ name: item.name, count: item.value }));
  const selections = Math.round(visitors * 0.09);

  return {
    totals: webTotals(pageviews, visitors),
    previous: webTotals(Math.round(pageviews * 0.87), Math.round(visitors * 0.9)),
    series,
    breakdowns: {
      referrer: ranked([["", 0.34], ["github.com", 0.24], ["communityfund.stellar.org", 0.17], ["google.com", 0.12], ["stellar.org", 0.08], ["x.com", 0.05]]),
      country: ranked([["US", 0.27], ["BR", 0.21], ["DE", 0.13], ["GB", 0.1], ["IN", 0.09], ["NG", 0.08], ["FR", 0.06], ["AR", 0.06]]),
      device: ranked([["desktop", 0.48], ["laptop", 0.27], ["mobile", 0.22], ["tablet", 0.03]]),
      browser: ranked([["chrome", 0.55], ["firefox", 0.17], ["safari", 0.13], ["ios", 0.09], ["edge-chromium", 0.06]]),
    },
    events: counted(Math.round(pageviews * 0.3), [["demo_opened", 0.42], ["docs_opened", 0.27], ["repository_opened", 0.19], ["wallet_selected", 0.12]]),
    wallets: {
      selections: counted(selections, [["freighter", 0.46], ["xbull", 0.22], ["lobstr", 0.18], ["albedo", 0.14]]),
      disconnects: Math.round(selections * 0.3),
    },
  };
}

const DAILY_REQUESTS = 34_000;

// method, route, share of requests, 4xx share, 5xx share, p50 and p95 in seconds.
const ENDPOINTS = [
  ["GET", "/accounts/{address}", 0.38, 0.021, 0.001, 0.038, 0.16],
  ["GET", "/accounts/{address}/payments", 0.24, 0.012, 0.002, 0.071, 0.31],
  ["GET", "/ledgers/{id}", 0.2, 0.034, 0.001, 0.029, 0.12],
  ["POST", "/transactions", 0.1, 0.058, 0.009, 0.19, 0.74],
  ["GET", "/healthz", 0.08, 0, 0, 0.004, 0.011],
] as const;

const CLIENT_SHARE = ENDPOINTS.reduce((sum, e) => sum + e[2] * e[3], 0);
const SERVER_SHARE = ENDPOINTS.reduce((sum, e) => sum + e[2] * e[4], 0);

function apiCounts(requests: number, seed: number): ApiCounts {
  if (requests === 0) return { requests: 0, clientErrors: 0, serverErrors: 0, p50: null, p95: null };
  return {
    requests,
    clientErrors: Math.round(requests * CLIENT_SHARE),
    serverErrors: Math.round(requests * SERVER_SHARE),
    p50: 0.04 + 0.015 * noise(seed),
    p95: 0.24 + 0.12 * noise(seed + 7),
  };
}

export function sampleServiceDashboard(period: Period): ApiServiceDashboard {
  const series = period.buckets.map((at, i) => ({
    at,
    ...apiCounts(Math.round(DAILY_REQUESTS * weight(period.unit, at, 2) * open(period, i)), Math.floor(at.getTime() / 60_000)),
  }));
  const requests = series.reduce((sum, p) => sum + p.requests, 0);
  const clientErrors = series.reduce((sum, p) => sum + p.clientErrors, 0);
  const serverErrors = series.reduce((sum, p) => sum + p.serverErrors, 0);
  return {
    totals: { requests, clientErrors, serverErrors, p50: requests > 0 ? 0.047 : null, p95: requests > 0 ? 0.29 : null },
    series,
    endpoints: ENDPOINTS.map(([method, route, share, client, server, p50, p95]) => {
      const n = Math.round(requests * share);
      return { method, route, requests: n, clientErrors: Math.round(n * client), serverErrors: Math.round(n * server), p50, p95 };
    }),
    endpointCount: ENDPOINTS.length,
    statuses: [
      { statusCode: 200, requests: requests - clientErrors - serverErrors },
      { statusCode: 404, requests: Math.round(clientErrors * 0.62) },
      { statusCode: 400, requests: clientErrors - Math.round(clientErrors * 0.62) },
      { statusCode: 500, requests: serverErrors },
    ].filter((s) => s.requests > 0),
  };
}

// The demo operator view: the same sample project as one row of each panel.
export function sampleWebOverview(period: Period): { projects: ProjectWebStats[]; unavailable: number } {
  const { totals, previous } = sampleSiteDashboard(period);
  return { projects: [{ tenantId: SAMPLE_PROJECT.id, name: SAMPLE_PROJECT.name, slug: SAMPLE_PROJECT.slug, sites: 1, totals, previous }], unavailable: 0 };
}

export function sampleApiOverview(period: Period): ProjectApiStats[] {
  const { totals } = sampleServiceDashboard(period);
  return [{ tenantId: SAMPLE_PROJECT.id, name: SAMPLE_PROJECT.name, slug: SAMPLE_PROJECT.slug, services: 1, totals }];
}
