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
} from "@/lib/format";
import { DeltaText } from "@/components/delta-text";
import { PeriodPicker } from "@/components/period-picker";
import { parsePeriodKey, resolvePeriod } from "@/lib/period";
import { getSiteDashboard, type RankedItem, type SiteDashboard, UmamiError } from "@/lib/umami/stats";
import { PageviewsChart } from "./pageviews-chart";

export const metadata: Metadata = { title: "Website analytics" };

const card = "rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900";

// Painel web do tenant (#28): as 7 métricas mínimas de um site no período
// escolhido. Site de outro tenant (ou arquivado) responde 404 antes de qualquer
// chamada ao Umami; projeto removido vê só o aviso (spec do E2, seção 6).
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
      <Link href="/sites" className="text-sm text-zinc-500 hover:underline">
        ← Websites
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">{site.name}</h1>
      <p className="mt-1 text-sm text-zinc-500">{site.domain}</p>
    </>
  );

  if (ctx.tenantStatus === "removed") {
    const project = await getProject(ctx);
    return (
      <section>
        {header}
        <p className="mt-6 text-zinc-500">This project was removed by the SCF operators.</p>
        {project.statusReason && <p className="mt-2 text-sm text-zinc-500">Reason: {project.statusReason}</p>}
      </section>
    );
  }

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
        <p role="alert" className="mt-6 text-zinc-500">
          Web analytics is unavailable right now. Try again in a few minutes.
        </p>
      </section>
    );
  }
  if (!data) notFound();

  const { totals, previous, series, breakdowns } = data;
  const vsLabel = `vs previous ${period.label.replace(/^Last /, "")}`;
  const points = series.map((p) => ({
    label: bucketLabel(period.unit, p.at),
    longLabel: bucketLabel(period.unit, p.at, true),
    pageviews: p.pageviews,
    visitors: p.visitors,
  }));
  const last = points.length - 1;
  const empty = totals.pageviews === 0;

  return (
    <section>
      {header}
      <PeriodPicker current={period.key} href={(key) => `/sites/${site.id}?period=${key}`} />

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Page views"
          value={formatCount(totals.pageviews)}
          delta={relativeDelta(totals.pageviews, previous.pageviews)}
          vs={vsLabel}
        />
        <StatTile
          label="Unique visitors"
          value={formatCount(totals.visitors)}
          delta={relativeDelta(totals.visitors, previous.visitors)}
          vs={vsLabel}
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

      <div className={`mt-4 ${card}`}>
        <h2 className="font-medium">Page views</h2>
        <p className="text-sm text-zinc-500">
          {period.label}, per {period.unit} (UTC), including the current {period.unit}
        </p>
        {empty && <p className="mt-2 text-sm text-zinc-500">No page views in this period yet.</p>}
        <div className="mt-4">
          <PageviewsChart points={points} axisLabels={last > 1 ? [0, Math.floor(last / 2), last] : [0, last]} />
        </div>
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-zinc-500">Show as table</summary>
          <div className="mt-2 max-h-72 overflow-y-auto">
            <table className="w-full text-left tabular-nums">
              <thead className="text-zinc-500">
                <tr>
                  <th className="py-1 font-medium">{period.unit === "hour" ? "Hour" : period.unit === "day" ? "Day" : "Month"}</th>
                  <th className="py-1 text-right font-medium">Page views</th>
                  <th className="py-1 text-right font-medium">Visitors</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {points.map((p) => (
                  <tr key={p.longLabel}>
                    <td className="py-1">{p.longLabel}</td>
                    <td className="py-1 text-right">{p.pageviews.toLocaleString("en")}</td>
                    <td className="py-1 text-right">{p.visitors.toLocaleString("en")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <RankedList title="Referrers" items={breakdowns.referrer} name={referrerName} />
        <RankedList title="Countries" items={breakdowns.country} name={countryName} />
        <RankedList title="Devices" items={breakdowns.device} name={deviceName} />
        <RankedList title="Browsers" items={breakdowns.browser} name={browserName} />
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
}: {
  label: string;
  value: string;
  delta: Delta;
  vs: string;
  upIsGood?: boolean;
}) {
  return (
    <div className={card}>
      <p className="text-sm text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-xs">
        {delta ? (
          <>
            <DeltaText delta={delta} upIsGood={upIsGood} /> <span className="text-zinc-500">{vs}</span>
          </>
        ) : (
          <span className="text-zinc-500">No data for the previous period</span>
        )}
      </p>
    </div>
  );
}

// Lista ordenada: nome, barra e número por linha, barras alinhadas. A barra
// usa a mesma cor da série do gráfico; o número fica sempre visível.
function RankedList({ title, items, name }: { title: string; items: RankedItem[]; name: (raw: string) => string }) {
  const max = Math.max(1, ...items.map((i) => i.visitors));
  return (
    <div className={`${card} [--series:#2a78d6] dark:[--series:#3987e5]`}>
      <div className="flex items-baseline justify-between">
        <h2 className="font-medium">{title}</h2>
        <span className="text-xs text-zinc-500">Visitors</span>
      </div>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">No data in this period.</p>
      ) : (
        <ol className="mt-3 space-y-2 text-sm">
          {items.map((item) => (
            <li key={item.name}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate" title={name(item.name)}>
                  {name(item.name)}
                </span>
                <span className="tabular-nums">{item.visitors.toLocaleString("en")}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-r-[4px] bg-[var(--series)]" style={{ width: `${(item.visitors / max) * 100}%` }} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
