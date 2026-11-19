import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenantContext } from "@/lib/access";
import { getSite } from "@/lib/data/sites";
import { getProject } from "@/lib/data/tenants";
import {
  averageVisitSeconds,
  bounceRate,
  browserName,
  bucketLabel,
  countryName,
  type Delta,
  deviceName,
  formatCount,
  formatDuration,
  formatPercent,
  pointsDelta,
  referrerName,
  relativeDelta,
  walletName,
} from "@/lib/format";
import { DeltaBadge } from "@/components/metrics/delta-badge";
import { MetricCard } from "@/components/metrics/metric-card";
import { PeriodPicker } from "@/components/metrics/period-picker";
import { RankedList, type RankedRow } from "@/components/metrics/ranked-list";
import { cardClass } from "@/components/ui/card";
import { ChartFrame } from "@/components/charts/chart-frame";
import { DonutChart } from "@/components/charts/donut-chart";
import { Sparkline } from "@/components/charts/sparkline";
import { parsePeriodKey, resolvePeriod } from "@/lib/period";
import { type CountedItem, getSiteDashboard, type RankedItem, type SiteDashboard, UmamiError } from "@/lib/umami/stats";
import { trackerSnippets } from "@/lib/tracker-snippet";
import { InstallScript } from "./install-script";
import { PageviewsChart } from "./pageviews-chart";

export const metadata: Metadata = { title: "Website analytics" };

const card = cardClass;

// Tenant web dashboard (#28): the 7 minimum metrics of a site in the chosen
// period, plus custom events and wallets (#50). Another tenant's (or an
// archived) site answers 404 before any Umami call; a removed project sees only
// the notice (E2 spec, section 6).
export default async function SitePage({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ period?: string | string[] }>;
}) {
  const [{ siteId }, query] = await Promise.all([params, searchParams]);
  const ctx = await requireTenantContext();
  const site = await getSite(ctx, siteId);
  if (!site) notFound();

  const header = (
    <>
      <Link href="/sites" className="text-sm text-muted hover:underline">
        ← Websites
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{site.name}</h1>
      <p className="mt-1 text-sm text-muted">{site.domain}</p>
    </>
  );

  if (ctx.tenantStatus === "removed") {
    const project = await getProject(ctx);
    return (
      <section>
        {header}
        <p className="mt-6 text-muted">This project was removed by the SCF operators.</p>
        {project.statusReason && <p className="mt-2 text-sm text-muted">Reason: {project.statusReason}</p>}
      </section>
    );
  }

  // Installation tag (self-service enrollment): open while the site shows no
  // page views, collapsed once data arrives.
  const install = (open: boolean) => (
    <details id="install" open={open} className={`mt-6 ${card}`}>
      <summary className="cursor-pointer font-semibold">Install the tracking script</summary>
      <InstallScript snippets={trackerSnippets(site.umamiWebsiteId)} domain={site.domain} />
    </details>
  );

  const period = resolvePeriod(parsePeriodKey(query.period));
  let data: SiteDashboard | null;
  try {
    data = await getSiteDashboard(ctx, site.id, period);
  } catch (error) {
    if (!(error instanceof UmamiError)) throw error;
    // O detalhe fica só no log.
    console.error("Falha ao ler o painel web", error.message);
    return (
      <section>
        {header}
        <PeriodPicker current={period.key} href={(key) => `/sites/${site.id}?period=${key}`} />
        <p role="alert" className="mt-6 text-muted">
          Web analytics is unavailable right now. Try again in a few minutes.
        </p>
        {install(true)}
      </section>
    );
  }
  if (!data) notFound();

  const { totals, previous, series, breakdowns, events, wallets } = data;
  const vsLabel = `vs previous ${period.label.replace(/^Last /, "")}`;
  const points = series.map((p) => ({
    label: bucketLabel(period.unit, p.at),
    longLabel: bucketLabel(period.unit, p.at, true),
    pageviews: p.pageviews,
    visitors: p.visitors,
  }));
  const empty = totals.pageviews === 0;

  return (
    <section>
      {header}
      <PeriodPicker current={period.key} href={(key) => `/sites/${site.id}?period=${key}`} />

      {install(empty)}

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Page views"
          value={formatCount(totals.pageviews)}
          delta={relativeDelta(totals.pageviews, previous.pageviews)}
          vs={vsLabel}
          trend={points.map((p) => p.pageviews)}
        />
        <StatTile
          label="Unique visitors"
          value={formatCount(totals.visitors)}
          delta={relativeDelta(totals.visitors, previous.visitors)}
          vs={vsLabel}
          trend={points.map((p) => p.visitors)}
        />
        <StatTile
          label="Average visit duration"
          value={formatDuration(averageVisitSeconds(totals))}
          delta={relativeDelta(averageVisitSeconds(totals), averageVisitSeconds(previous), previous.visits)}
          vs={vsLabel}
        />
        <StatTile
          label="Bounce rate"
          value={totals.visits > 0 ? formatPercent(bounceRate(totals)) : "—"}
          delta={pointsDelta(bounceRate(totals), bounceRate(previous), totals.visits, previous.visits)}
          vs={vsLabel}
          upIsGood={false}
        />
      </div>

      <ChartFrame
        className="mt-4"
        title="Page views"
        subtitle={`${period.label}, per ${period.unit} (UTC), including the current ${period.unit}`}
        table={
            <table className="w-full text-left tabular-nums">
              <thead className="text-muted">
                <tr>
                  <th className="py-1 font-medium">{period.unit === "hour" ? "Hour" : period.unit === "day" ? "Day" : "Month"}</th>
                  <th className="py-1 text-right font-medium">Page views</th>
                  <th className="py-1 text-right font-medium">Visitors</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {points.map((p) => (
                  <tr key={p.longLabel}>
                    <td className="py-1">{p.longLabel}</td>
                    <td className="py-1 text-right">{p.pageviews.toLocaleString("en")}</td>
                    <td className="py-1 text-right">{p.visitors.toLocaleString("en")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
        }
      >
        {empty && <p className="mb-2 text-sm text-muted">No page views in this period yet.</p>}
        <PageviewsChart points={points} />
      </ChartFrame>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <RankedList title="Referrers" unit="Visitors" rows={ranked(byVisitors(breakdowns.referrer), referrerName)} />
        <RankedList title="Countries" unit="Visitors" rows={ranked(byVisitors(breakdowns.country), countryName)} />
        <ShareCard title="Devices" unit="Visitors" rows={ranked(byVisitors(breakdowns.device), deviceName)} />
        <ShareCard title="Browsers" unit="Visitors" rows={ranked(byVisitors(breakdowns.browser), browserName)} />
      </div>

      {/* Custom events and wallets (#50, ADR 0015). */}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <RankedList
          title="Custom events"
          unit="Events"
          rows={ranked(byCount(events), (raw) => raw)}
          empty="No custom events in this period. Send them with stellytics.event()."
        />
        <RankedList
          title="Wallet connections"
          unit="Selections"
          rows={ranked(byCount(wallets.selections), walletName)}
          empty="No wallet selections in this period. Track them with stellytics.wallets()."
          footer={`Disconnections: ${wallets.disconnects.toLocaleString("en")}`}
        />
      </div>
    </section>
  );
}

function StatTile({
  label,
  value,
  delta,
  vs,
  upIsGood = true,
  trend,
}: {
  label: string;
  value: string;
  delta: Delta;
  vs: string;
  upIsGood?: boolean;
  trend?: number[];
}) {
  return (
    <MetricCard label={label} value={value} chart={trend && <Sparkline values={trend} />}>
      {delta ? (
        <>
          <DeltaBadge delta={delta} upIsGood={upIsGood} /> <span className="text-muted">{vs}</span>
        </>
      ) : (
        <span className="text-muted">No data for the previous period</span>
      )}
    </MetricCard>
  );
}

type ListItem = { name: string; value: number };

const byVisitors = (items: RankedItem[]): ListItem[] => items.map((i) => ({ name: i.name, value: i.visitors }));
const byCount = (items: CountedItem[]): ListItem[] => items.map((i) => ({ name: i.name, value: i.count }));

function ranked(items: ListItem[], name: (raw: string) => string): RankedRow[] {
  return items.map((item) => ({ key: item.name, name: name(item.name), value: item.value, display: item.value.toLocaleString("en") }));
}

function ShareCard({ title, unit, rows }: { title: string; unit: string; rows: RankedRow[] }) {
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return (
    <div className={card}>
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold">{title}</h2>
        <span className="text-xs text-muted">{unit}</span>
      </div>
      <div className="mt-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted">No data in this period.</p>
        ) : (
          <DonutChart items={rows.map((row) => ({ key: row.key, name: row.name, value: row.value, display: row.display }))} total={total} />
        )}
      </div>
    </div>
  );
}
