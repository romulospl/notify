import "server-only";
import type { DemoContext, OperatorContext } from "../access";
import { type ActiveTenantSites, listActiveTenantSites, listDemoTenantSites } from "../data/operator/sites";
import type { Period } from "../period";
import { type Breakdown, BREAKDOWNS, readBreakdown, readStats, type Totals } from "./read";
import type { RankedItem } from "./stats";

// Global SCF web dashboard (#29): the metrics of all active projects and the
// side-by-side comparison of some of them. Only the operator calls this
// (OperatorContext).
//
// The Umami IDs always come from listActiveTenantSites, never from the URL: an
// unknown, removed or pending tenantId is discarded before any call. A project
// with several sites sums the sites (visitors too: Umami counts sessions per
// site).
//
// Cost: the table makes one call (/stats) per site and the comparison, 5 per
// site of the chosen projects. All of them go through the same limiter, which
// counts HTTP calls (not sites): at most MAX_PARALLEL reads of the global
// dashboards at the same time in the process, adding up the table, the
// comparison and other operators opening the page. For the pilots that is
// enough; with hundreds of sites, reading the Umami database directly or
// storing a summary changes ADR 0002 and becomes a new ADR.

export const MAX_PARALLEL = 8;
export const COMPARE_MIN = 2;
export const COMPARE_MAX = 4;
export const COMPARE_TOP = 5;
// Each site contributes the first 10 rows of each list; the sum across sites
// is an approximation when an item falls outside the top 10 of some site.
const SITE_TOP = 10;

const ZERO: Totals = { pageviews: 0, visitors: 0, visits: 0, bounces: 0, totaltime: 0 };

function add(a: Totals, b: Totals): Totals {
  return {
    pageviews: a.pageviews + b.pageviews,
    visitors: a.visitors + b.visitors,
    visits: a.visits + b.visits,
    bounces: a.bounces + b.bounces,
    totaltime: a.totaltime + b.totaltime,
  };
}

// Semaphore: at most `limit` calls in progress. A slot is only released when
// the call finishes (with success or error), so a quick failure does not make
// room for more calls than the limit.
function createLimiter(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

const limited = createLimiter(MAX_PARALLEL);

export type ProjectWebStats = {
  tenantId: string;
  name: string;
  slug: string;
  sites: number;
  // Null when one of the project's sites did not answer: the project appears as
  // unavailable, instead of with partial numbers.
  totals: Totals | null;
  previous: Totals | null;
};

type SiteResult = { totals: Totals; previous: Totals };

function aggregate(project: ActiveTenantSites, results: PromiseSettledResult<SiteResult>[]): ProjectWebStats {
  const base = { tenantId: project.tenantId, name: project.name, slug: project.slug, sites: project.sites.length };
  if (results.some((r) => r.status === "rejected")) return { ...base, totals: null, previous: null };
  const ok = results.map((r) => (r as PromiseFulfilledResult<SiteResult>).value);
  return {
    ...base,
    totals: ok.reduce((sum, r) => add(sum, r.totals), ZERO),
    previous: ok.reduce((sum, r) => add(sum, r.previous), ZERO),
  };
}

async function siteTotals(umamiWebsiteId: string, period: Period): Promise<SiteResult> {
  const { comparison, ...totals } = await limited(() => readStats(umamiWebsiteId, period));
  return { totals, previous: comparison };
}

export async function getWebOverview(
  ctx: OperatorContext,
  period: Period,
): Promise<{ projects: ProjectWebStats[]; unavailable: number }> {
  return webOverview(await listActiveTenantSites(ctx), period);
}

// Same numbers for the public demo's operator view: the Umami IDs come only
// from the demo tenant's own sites.
export async function getDemoWebOverview(
  ctx: DemoContext,
  period: Period,
): Promise<{ projects: ProjectWebStats[]; unavailable: number }> {
  return webOverview(await listDemoTenantSites(ctx), period);
}

async function webOverview(
  projects: ActiveTenantSites[],
  period: Period,
): Promise<{ projects: ProjectWebStats[]; unavailable: number }> {
  const sites = projects.flatMap((p) => p.sites.map((s) => ({ tenantId: p.tenantId, umamiWebsiteId: s.umamiWebsiteId })));
  const results = await Promise.allSettled(sites.map((s) => siteTotals(s.umamiWebsiteId, period)));

  const rows = projects.map((p) =>
    aggregate(
      p,
      sites.flatMap((s, i) => (s.tenantId === p.tenantId ? [results[i]!] : [])),
    ),
  );
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    // Only the count: the log carries no site ID or Umami detail.
    console.error("Global dashboard: sites with no response from Umami", failed.length);
  }
  return { projects: rows, unavailable: rows.filter((r) => r.totals === null).length };
}

export type ProjectComparison = ProjectWebStats & { breakdowns: Record<Breakdown, RankedItem[]> | null };

// IDs requested in the URL that belong to active projects, without repetition, in the requested order.
export function pickComparable(projects: { tenantId: string }[], requested: string[]): string[] {
  const active = new Set(projects.map((p) => p.tenantId));
  return [...new Set(requested)].filter((id) => active.has(id)).slice(0, COMPARE_MAX);
}

function mergeRanked(lists: { x: string | null; y: number }[][]): RankedItem[] {
  const sum = new Map<string, number>();
  for (const list of lists) for (const p of list) sum.set(p.x ?? "", (sum.get(p.x ?? "") ?? 0) + Number(p.y));
  return [...sum]
    .map(([name, visitors]) => ({ name, visitors }))
    .sort((a, b) => b.visitors - a.visitors || a.name.localeCompare(b.name))
    .slice(0, COMPARE_TOP);
}

// Side-by-side comparison: the 7 metrics of 2 to 4 active projects. Unknown
// IDs are discarded; with fewer than COMPARE_MIN valid ones, it returns null
// and nothing reaches Umami.
export async function compareProjects(
  ctx: OperatorContext,
  requested: string[],
  period: Period,
): Promise<ProjectComparison[] | null> {
  const projects = await listActiveTenantSites(ctx);
  const ids = pickComparable(projects, requested);
  if (ids.length < COMPARE_MIN) return null;
  const chosen = ids.map((id) => projects.find((p) => p.tenantId === id)!);

  // Each site makes 5 calls, all through the shared limiter.
  type SiteFull = SiteResult & { lists: { x: string | null; y: number }[][] };
  const sites = chosen.flatMap((p) => p.sites.map((s) => ({ tenantId: p.tenantId, umamiWebsiteId: s.umamiWebsiteId })));
  const results = await Promise.allSettled(
    sites.map(async (s): Promise<SiteFull> => {
      const [totals, ...lists] = await Promise.all([
        siteTotals(s.umamiWebsiteId, period),
        ...BREAKDOWNS.map((type) => limited(() => readBreakdown(s.umamiWebsiteId, type, period, SITE_TOP))),
      ]);
      return { ...totals, lists };
    }),
  );

  return chosen.map((project) => {
    const own = sites.flatMap((s, i) => (s.tenantId === project.tenantId ? [results[i]!] : []));
    const stats = aggregate(project, own);
    if (stats.totals === null) return { ...stats, breakdowns: null };
    const ok = own.map((r) => (r as PromiseFulfilledResult<SiteFull>).value);
    return {
      ...stats,
      breakdowns: Object.fromEntries(
        BREAKDOWNS.map((type, i) => [type, mergeRanked(ok.map((site) => site.lists[i]!))]),
      ) as Record<Breakdown, RankedItem[]>,
    };
  });
}
