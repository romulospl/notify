import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { DeltaText } from "@/components/delta-text";
import { PeriodPicker } from "@/components/period-picker";
import { requireOperatorContext } from "@/lib/access";
import {
  averageVisitSeconds,
  bounceRate,
  browserName,
  countryName,
  deviceName,
  formatCount,
  formatDuration,
  formatPercent,
  pointsDelta,
  referrerName,
  relativeDelta,
} from "@/lib/format";
import { parsePeriodKey, type PeriodKey, resolvePeriod } from "@/lib/period";
import {
  COMPARE_MAX,
  COMPARE_MIN,
  compareProjects,
  getWebOverview,
  type ProjectComparison,
  type ProjectWebStats,
} from "@/lib/umami/overview";
import type { Breakdown, RankedItem, Totals } from "@/lib/umami/stats";

export const metadata: Metadata = { title: "Web analytics across projects" };

// Painel web global do SCF (#29): as métricas web de todos os projetos ativos,
// com filtro por nome, ordenação por coluna e comparação lado a lado de 2 a 4
// projetos. Tudo por GET (links e formulários), sem depender de JavaScript.
// Quem não é operador recebe 404. Projeto removido não entra (spec do E2,
// seção 6); o operador ainda o abre em /operator/tenants/[tenantId].

const SORTS = {
  name: { label: "Project", value: (p: ProjectWebStats) => p.name.toLowerCase() },
  sites: { label: "Websites", value: (p: ProjectWebStats) => p.sites },
  pageviews: { label: "Page views", value: (p: ProjectWebStats) => p.totals?.pageviews ?? 0 },
  visitors: { label: "Visitors", value: (p: ProjectWebStats) => p.totals?.visitors ?? 0 },
  duration: { label: "Avg. visit", value: (p: ProjectWebStats) => (p.totals ? averageVisitSeconds(p.totals) : 0) },
  bounce: { label: "Bounce rate", value: (p: ProjectWebStats) => (p.totals ? bounceRate(p.totals) : 0) },
} as const;
type SortKey = keyof typeof SORTS;

type Query = { period?: string | string[]; sort?: string | string[]; dir?: string | string[]; q?: string | string[]; compare?: string | string[] };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const many = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

function sortProjects(projects: ProjectWebStats[], key: SortKey, dir: "asc" | "desc") {
  const value = SORTS[key].value;
  return [...projects].sort((a, b) => {
    // Projeto indisponível fica sempre no fim.
    if ((a.totals === null) !== (b.totals === null)) return a.totals === null ? 1 : -1;
    const va = value(a);
    const vb = value(b);
    const cmp = typeof va === "string" ? va.localeCompare(vb as string) : va - (vb as number);
    return (dir === "asc" ? cmp : -cmp) || a.name.localeCompare(b.name);
  });
}

export default async function OperatorWebPage({ searchParams }: { searchParams: Promise<Query> }) {
  const ctx = await requireOperatorContext();
  const query = await searchParams;
  const period = resolvePeriod(parsePeriodKey(query.period));
  const sortRaw = one(query.sort);
  const sort: SortKey = Object.hasOwn(SORTS, sortRaw) ? (sortRaw as SortKey) : "pageviews";
  const dir = one(query.dir) === "asc" ? "asc" : one(query.dir) === "desc" ? "desc" : sort === "name" ? "asc" : "desc";
  const filter = one(query.q).trim().slice(0, 100);
  const requested = many(query.compare).slice(0, 20);

  const [overview, comparison] = await Promise.all([
    getWebOverview(ctx, period),
    requested.length > 0 ? compareProjects(ctx, requested, period) : Promise.resolve(null),
  ]);

  const needle = filter.toLowerCase();
  const visible = sortProjects(
    overview.projects.filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.slug.includes(needle)),
    sort,
    dir,
  );
  const selected = new Set(comparison?.map((c) => c.tenantId) ?? []);
  // Só os indisponíveis que estão na tela (o filtro pode esconder outros).
  const unavailable = visible.filter((p) => p.totals === null).length;
  const maxPageviews = Math.max(1, ...visible.map((p) => p.totals?.pageviews ?? 0));

  // Monta a URL mantendo o resto do estado da página.
  const href = (change: Partial<Record<"period" | "sort" | "dir" | "q", string>> & { compare?: string[] }) => {
    const params = new URLSearchParams();
    const state = { period: period.key as string, sort, dir, q: filter, ...change };
    for (const k of ["period", "sort", "dir", "q"] as const) if (state[k]) params.set(k, state[k]);
    for (const id of change.compare ?? [...selected]) params.append("compare", id);
    return `/operator/web?${params}`;
  };
  const vsLabel = `vs previous ${period.label.replace(/^Last /, "")}`;

  return (
    <section>
      <Link href="/operator" className="text-sm text-zinc-500 hover:underline">
        ← SCF overview
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Web analytics across projects</h1>
      <p className="mt-2 text-zinc-500">
        Active projects only. Projects with several websites add them up. All times in UTC.
      </p>

      <PeriodPicker current={period.key} href={(key: PeriodKey) => href({ period: key })} />

      <form method="get" action="/operator/web" className="mt-4 flex flex-wrap items-end gap-3 text-sm" role="search">
        <input type="hidden" name="period" value={period.key} />
        <input type="hidden" name="sort" value={sort} />
        <input type="hidden" name="dir" value={dir} />
        {[...selected].map((id) => (
          <input key={id} type="hidden" name="compare" value={id} />
        ))}
        <label className="block min-w-56">
          <span className="font-medium">Filter projects</span>
          <input
            name="q"
            defaultValue={filter}
            maxLength={100}
            placeholder="Name or slug"
            className="mt-1 block w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 outline-none focus:border-zinc-900 dark:border-zinc-700 dark:focus:border-zinc-100"
          />
        </label>
        <button type="submit" className="rounded-md border border-zinc-300 px-3 py-2 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
          Apply
        </button>
        {filter && (
          <Link href={href({ q: "" })} className="py-2 text-zinc-500 hover:underline">
            Clear
          </Link>
        )}
      </form>

      {unavailable > 0 && (
        <p role="alert" className="mt-4 text-sm text-zinc-500">
          Couldn&apos;t read web analytics for {unavailable} project{unavailable === 1 ? "" : "s"}; they show as
          unavailable. If this persists, check that their websites still exist in web analytics.
        </p>
      )}

      {comparison && <Comparison projects={comparison} vsLabel={vsLabel} clearHref={href({ compare: [] })} />}
      {requested.length > 0 && !comparison && (
        <p role="alert" className="mt-6 text-sm text-zinc-500">
          Select between {COMPARE_MIN} and {COMPARE_MAX} active projects to compare them.
        </p>
      )}

      <form method="get" action="/operator/web" className="mt-6">
        <input type="hidden" name="period" value={period.key} />
        <input type="hidden" name="sort" value={sort} />
        <input type="hidden" name="dir" value={dir} />
        {filter && <input type="hidden" name="q" value={filter} />}
        {/* Selecionados que o filtro esconde continuam na comparação. */}
        {[...selected]
          .filter((id) => !visible.some((p) => p.tenantId === id))
          .map((id) => (
            <input key={id} type="hidden" name="compare" value={id} />
          ))}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
              <tr>
                <th className="w-8 py-2">
                  <span className="sr-only">Compare</span>
                </th>
                {(Object.keys(SORTS) as SortKey[]).map((key) => {
                  const active = key === sort;
                  const nextDir = active ? (dir === "asc" ? "desc" : "asc") : key === "name" ? "asc" : "desc";
                  return (
                    <th
                      key={key}
                      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}
                      className={`py-2 font-medium ${key === "name" ? "" : "text-right"}`}
                    >
                      <Link href={href({ sort: key, dir: nextDir })} className={`hover:underline ${active ? "text-zinc-900 dark:text-zinc-100" : ""}`}>
                        {SORTS[key].label}
                        {active && <span aria-hidden>{dir === "asc" ? " ↑" : " ↓"}</span>}
                      </Link>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {visible.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-3 text-zinc-500">
                    {filter ? "No active project matches this filter." : "No active projects yet."}
                  </td>
                </tr>
              )}
              {visible.map((p) => (
                <tr key={p.tenantId} className="[--series:#2a78d6] dark:[--series:#3987e5]">
                  <td className="py-2 align-top">
                    <input
                      type="checkbox"
                      name="compare"
                      value={p.tenantId}
                      defaultChecked={selected.has(p.tenantId)}
                      aria-label={`Compare ${p.name}`}
                      className="mt-0.5"
                    />
                  </td>
                  <td className="py-2 align-top">
                    <Link href={`/operator/tenants/${p.tenantId}`} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                    <span className="ml-2 font-mono text-xs text-zinc-500">{p.slug}</span>
                  </td>
                  <td className="py-2 text-right align-top tabular-nums">{p.sites}</td>
                  {p.totals === null ? (
                    <td colSpan={4} className="py-2 text-right align-top text-zinc-500">
                      Unavailable
                    </td>
                  ) : (
                    <>
                      <td className="py-2 text-right align-top tabular-nums">
                        {formatCount(p.totals.pageviews)}
                        <div className="mt-1 flex justify-end" aria-hidden>
                          <div
                            className="h-1 rounded-l-[4px] bg-[var(--series)]"
                            style={{ width: `${(p.totals.pageviews / maxPageviews) * 6}rem` }}
                          />
                        </div>
                        <Change delta={relativeDelta(p.totals.pageviews, p.previous!.pageviews)} />
                      </td>
                      <td className="py-2 text-right align-top tabular-nums">
                        {formatCount(p.totals.visitors)}
                        <Change delta={relativeDelta(p.totals.visitors, p.previous!.visitors)} />
                      </td>
                      <td className="py-2 text-right align-top tabular-nums">
                        {p.totals.visits > 0 ? formatDuration(averageVisitSeconds(p.totals)) : "—"}
                      </td>
                      <td className="py-2 text-right align-top tabular-nums">
                        {p.totals.visits > 0 ? formatPercent(bounceRate(p.totals)) : "—"}
                        <Change
                          delta={pointsDelta(bounceRate(p.totals), bounceRate(p.previous!), p.totals.visits, p.previous!.visits)}
                          upIsGood={false}
                        />
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-3 py-2 font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Compare selected
          </button>
          <span className="text-zinc-500">
            Pick {COMPARE_MIN} to {COMPARE_MAX} projects. Changes are {vsLabel}.
          </span>
        </div>
      </form>
    </section>
  );
}

function Change({ delta, upIsGood = true }: { delta: ReturnType<typeof relativeDelta>; upIsGood?: boolean }) {
  if (!delta) return null;
  return (
    <span className="block text-xs">
      <DeltaText delta={delta} upIsGood={upIsGood} />
    </span>
  );
}

const BREAKDOWN_ROWS: { type: Breakdown; label: string; name: (raw: string) => string }[] = [
  { type: "referrer", label: "Top referrers", name: referrerName },
  { type: "country", label: "Top countries", name: countryName },
  { type: "device", label: "Devices", name: deviceName },
  { type: "browser", label: "Top browsers", name: browserName },
];

// Comparação lado a lado: uma coluna por projeto, uma linha por métrica.
function Comparison({ projects, vsLabel, clearHref }: { projects: ProjectComparison[]; vsLabel: string; clearHref: string }) {
  const metric = (label: string, cell: (totals: Totals, previous: Totals) => ReactNode) => (
    <tr>
      <th scope="row" className="py-2 pr-4 text-left align-top font-medium text-zinc-500">
        {label}
      </th>
      {projects.map((p) => (
        <td key={p.tenantId} className="py-2 pr-4 align-top tabular-nums">
          {p.totals && p.previous ? cell(p.totals, p.previous) : <span className="text-zinc-500">Unavailable</span>}
        </td>
      ))}
    </tr>
  );

  return (
    <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">Side-by-side comparison</h2>
        <Link href={clearHref} className="text-sm text-zinc-500 hover:underline">
          Clear comparison
        </Link>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <th className="py-2 pr-4 text-left font-medium text-zinc-500">
                <span className="sr-only">Metric</span>
              </th>
              {projects.map((p) => (
                <th key={p.tenantId} scope="col" className="py-2 pr-4 text-left font-medium">
                  {p.name}
                  <span className="block text-xs font-normal text-zinc-500">
                    {p.sites} website{p.sites === 1 ? "" : "s"}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {metric("Page views", (t, prev) => (
              <>
                {formatCount(t.pageviews)}
                <Change delta={relativeDelta(t.pageviews, prev.pageviews)} />
              </>
            ))}
            {metric("Unique visitors", (t, prev) => (
              <>
                {formatCount(t.visitors)}
                <Change delta={relativeDelta(t.visitors, prev.visitors)} />
              </>
            ))}
            {metric("Avg. visit duration", (t) => (t.visits > 0 ? formatDuration(averageVisitSeconds(t)) : "—"))}
            {metric("Bounce rate", (t, prev) => (
              <>
                {t.visits > 0 ? formatPercent(bounceRate(t)) : "—"}
                <Change delta={pointsDelta(bounceRate(t), bounceRate(prev), t.visits, prev.visits)} upIsGood={false} />
              </>
            ))}
            {BREAKDOWN_ROWS.map((row) => (
              <tr key={row.type}>
                <th scope="row" className="py-2 pr-4 text-left align-top font-medium text-zinc-500">
                  {row.label}
                  <span className="block text-xs font-normal">Visitors</span>
                </th>
                {projects.map((p) => (
                  <td key={p.tenantId} className="py-2 pr-4 align-top">
                    {p.breakdowns ? <TopList items={p.breakdowns[row.type]} name={row.name} /> : <span className="text-zinc-500">Unavailable</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-zinc-500">Changes are {vsLabel}.</p>
    </div>
  );
}

function TopList({ items, name }: { items: RankedItem[]; name: (raw: string) => string }) {
  if (items.length === 0) return <span className="text-zinc-500">No data</span>;
  return (
    <ol className="space-y-0.5">
      {items.map((item) => (
        <li key={item.name} className="flex justify-between gap-3">
          <span className="truncate">{name(item.name)}</span>
          <span className="tabular-nums">{item.visitors.toLocaleString("en")}</span>
        </li>
      ))}
    </ol>
  );
}
