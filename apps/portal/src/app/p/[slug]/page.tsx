import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DemoShell } from "@/components/demo/demo-shell";
import { DemoNotice } from "@/components/demo/demo-notice";
import { cardClass } from "@/components/ui/card";
import { loadDemoContext } from "@/lib/access";
import { type ApiCounts, type ApiServiceDashboard, getServiceDashboard } from "@/lib/data/api-metrics";
import { listApiServices } from "@/lib/data/api-services";
import { getDemoApiOverview } from "@/lib/data/operator/api";
import { listSites } from "@/lib/data/sites";
import { cachedDemo } from "@/lib/demo-cache";
import { SAMPLE_PROJECT, sampleApiOverview, sampleServiceDashboard, sampleSiteDashboard, sampleWebOverview } from "@/lib/demo-sample";
import { env } from "@/lib/env";
import { bucketLabel, formatCount, formatLatency, formatShare } from "@/lib/format";
import { type Period, resolvePeriod } from "@/lib/period";
import { getDemoWebOverview } from "@/lib/umami/overview";
import { getSiteDashboard, type SiteDashboard, type Totals, UmamiError } from "@/lib/umami/stats";
import { ColumnChart } from "@/components/charts/column-chart";

export const metadata: Metadata = { title: "Public project card" };
// Rendered per request: the demo mode and the data are read at run time.
export const dynamic = "force-dynamic";

// Public card of the demo project: what someone outside the project
// and outside SCF sees, with no session. Only aggregated totals and the daily
// series of a fixed period (visitors, API requests, page views, events, p50,
// p95, 5xx errors): no per-page, per-endpoint, referrer or country detail.
//
// The slug in the URL selects nothing. It must be the demo project's own slug
// (the sample project, or the tenant of DEMO_TENANT_SLUG); any other slug,
// including a real project's, answers 404 before anything is read. No other
// project has a public card.
const CARD_PERIOD = "30d" as const;

type Card = {
  web: { name: string; sites: number; totals: Totals | null };
  api: { services: number; totals: ApiCounts };
  sites: (SiteDashboard | null)[];
  services: ApiServiceDashboard[];
};

async function tenantCard(slug: string, period: Period): Promise<Card> {
  const ctx = await loadDemoContext();
  if (!ctx || ctx.slug !== slug) notFound();
  const key = `${ctx.tenantId}:${period.key}`;
  const [web, api, siteList, serviceList] = await Promise.all([
    cachedDemo(`op-web:${key}`, () => getDemoWebOverview(ctx, period)),
    cachedDemo(`op-api:${key}`, () => getDemoApiOverview(ctx, period)),
    cachedDemo(`sites:${ctx.tenantId}`, () => listSites(ctx)),
    cachedDemo(`services:${ctx.tenantId}`, () => listApiServices(ctx)),
  ]);
  const [sites, services] = await Promise.all([
    Promise.all(
      siteList.map((site) =>
        cachedDemo(`web:${key}:${site.id}`, () => getSiteDashboard(ctx, site.id, period)).catch((error: unknown) => {
          if (!(error instanceof UmamiError)) throw error;
          console.error("Demo: failed to read the web dashboard", error.message);
          return null;
        }),
      ),
    ),
    Promise.all(serviceList.map((service) => cachedDemo(`api:${key}:${service.id}`, () => getServiceDashboard(ctx, service.id, period)))),
  ]);
  if (!web.projects[0] || !api[0]) notFound();
  return {
    web: web.projects[0],
    api: api[0],
    sites,
    services: services.filter((d): d is ApiServiceDashboard => d !== null),
  };
}

function sampleCard(slug: string, period: Period): Card {
  if (slug !== SAMPLE_PROJECT.slug) notFound();
  return {
    web: sampleWebOverview(period).projects[0]!,
    api: sampleApiOverview(period)[0]!,
    sites: [sampleSiteDashboard(period)],
    services: [sampleServiceDashboard(period)],
  };
}

const full = new Intl.NumberFormat("en");
const plural = (n: number, one: string, many: string) => `${full.format(n)} ${n === 1 ? one : many}`;

// One value per bucket, summed across the project's sites or services.
function sumSeries<P>(period: Period, lists: P[][], pick: (point: P) => number): number[] {
  return period.buckets.map((_, i) => lists.reduce((sum, list) => sum + (list[i] ? pick(list[i]) : 0), 0));
}

function Panel({ title, value, unit, period, series }: { title: string; value: string; unit: string; period: Period; series: number[] }) {
  return (
    <section className="min-w-0">
      <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h2>
      <p className="mt-2 text-4xl font-semibold tracking-tight tabular-nums">{value}</p>
      <div className="mt-4">
        <ColumnChart
          label={`${unit} per day`}
          currentIncomplete
          points={period.buckets.map((at, i) => {
            const n = series[i] ?? 0;
            const longLabel = bucketLabel(period.unit, at, true);
            return {
              label: bucketLabel(period.unit, at),
              longLabel,
              value: n,
              description: `${longLabel}: ${plural(n, unit.replace(/s$/, ""), unit)}`,
              tooltip: [{ value: full.format(n), unit }],
            };
          })}
        />
      </div>
    </section>
  );
}

export default async function PublicCardPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const period = resolvePeriod(CARD_PERIOD);
  const sample = !env.demoTenantSlug;
  const { web, api, sites, services } = sample ? sampleCard(slug, period) : await tenantCard(slug, period);

  const webSeries = sumSeries(period, sites.flatMap((d) => (d ? [d.series] : [])), (p) => p.visitors);
  const apiSeries = sumSeries(period, services.map((d) => d.series), (p) => p.requests);
  const events = sites.reduce((sum, d) => sum + (d?.events.reduce((n, e) => n + e.count, 0) ?? 0), 0);
  const requests = api.totals.requests;

  const stats: { label: string; value: string }[] = [
    { label: "Page views", value: web.totals ? formatCount(web.totals.pageviews) : "—" },
    { label: "Events", value: formatCount(events) },
    { label: "API p50 latency", value: formatLatency(api.totals.p50) },
    { label: "API p95 latency", value: formatLatency(api.totals.p95) },
    { label: "Server errors (5xx)", value: formatCount(api.totals.serverErrors) },
  ];

  return (
    <DemoShell>
      <DemoNotice sample={sample} />
      <article className={`${cardClass} mt-6 p-0`}>
        <header className="p-6">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">Usage measured by stellytics</p>
          <h1 className="mt-1 text-4xl font-semibold tracking-tight">{web.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {period.label} · {plural(web.sites, "website", "websites")} · {plural(api.services, "API service", "API services")}
          </p>
        </header>

        <div className="grid gap-8 border-t border-border p-6 md:grid-cols-2">
          <Panel title="Visitors, 30 days" value={web.totals ? formatCount(web.totals.visitors) : "—"} unit="visitors" period={period} series={webSeries} />
          <Panel title="API requests, 30 days" value={formatCount(requests)} unit="requests" period={period} series={apiSeries} />
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-t border-border p-6 sm:grid-cols-3 lg:grid-cols-5">
          {stats.map((stat) => (
            <div key={stat.label}>
              <dt className="text-[0.8125rem] font-medium text-muted">{stat.label}</dt>
              <dd className="mt-1 text-2xl leading-tight font-semibold tracking-tight tabular-nums">{stat.value}</dd>
              {stat.label === "Server errors (5xx)" && requests > 0 && (
                <dd className="mt-0.5 text-xs text-muted">{formatShare(api.totals.serverErrors, requests)} of requests</dd>
              )}
            </div>
          ))}
        </dl>

        <p className="border-t border-border p-6 text-xs text-muted">
          Totals only, in UTC. Collected without cookies and without storing IP addresses. Visitors are counted per
          website.
        </p>
      </article>
    </DemoShell>
  );
}
