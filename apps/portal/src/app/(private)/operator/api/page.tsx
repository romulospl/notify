import type { Metadata } from "next";
import Link from "next/link";
import { PeriodPicker } from "@/components/metrics/period-picker";
import { requireOperatorContext } from "@/lib/access";
import { getApiOverview, type ProjectApiStats } from "@/lib/data/operator/api";
import { formatCount, formatLatency, formatShare } from "@/lib/format";
import { parsePeriodKey, type PeriodKey, resolvePeriod } from "@/lib/period";
import { cardClass } from "@/components/ui/card";
import { Icon } from "@/components/ui/icons";

export const metadata: Metadata = { title: "API analytics across projects" };

// Painel de API global do SCF (#38): volume, erros e latência de todos os
// projetos ativos, com filtro por nome, ordenação por coluna e seletor de
// período, para achar serviços muito ou pouco usados. Tudo por GET (links e
// formulário), sem depender de JavaScript. Quem não é operador recebe 404.
// Projeto removido não entra (spec do E2, seção 6).

const share = (part: number, total: number) => (total > 0 ? part / total : null);

// Valor nulo (projeto sem requisição) fica sempre no fim, nos dois sentidos.
const SORTS = {
  name: { label: "Project", value: (p: ProjectApiStats) => p.name.toLowerCase() },
  services: { label: "Services", value: (p: ProjectApiStats) => p.services },
  requests: { label: "Requests", value: (p: ProjectApiStats) => p.totals.requests },
  server: { label: "5xx", value: (p: ProjectApiStats) => share(p.totals.serverErrors, p.totals.requests) },
  client: { label: "4xx", value: (p: ProjectApiStats) => share(p.totals.clientErrors, p.totals.requests) },
  p50: { label: "p50", value: (p: ProjectApiStats) => p.totals.p50 },
  p95: { label: "p95", value: (p: ProjectApiStats) => p.totals.p95 },
} as const;
type SortKey = keyof typeof SORTS;

type Query = { period?: string | string[]; sort?: string | string[]; dir?: string | string[]; q?: string | string[] };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

function sortProjects(projects: ProjectApiStats[], key: SortKey, dir: "asc" | "desc") {
  const value = SORTS[key].value;
  return [...projects].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if ((va === null) !== (vb === null)) return va === null ? 1 : -1;
    const cmp =
      va === null ? 0 : typeof va === "string" ? va.localeCompare(vb as string) : va - (vb as number);
    return (dir === "asc" ? cmp : -cmp) || a.name.localeCompare(b.name);
  });
}

export default async function OperatorApiPage({ searchParams }: { searchParams: Promise<Query> }) {
  const ctx = await requireOperatorContext();
  const query = await searchParams;
  const period = resolvePeriod(parsePeriodKey(query.period));
  const sortRaw = one(query.sort);
  const sort: SortKey = Object.hasOwn(SORTS, sortRaw) ? (sortRaw as SortKey) : "requests";
  const dir = one(query.dir) === "asc" ? "asc" : one(query.dir) === "desc" ? "desc" : sort === "name" ? "asc" : "desc";
  const filter = one(query.q).trim().slice(0, 100);

  const projects = await getApiOverview(ctx, period);
  const needle = filter.toLowerCase();
  const visible = sortProjects(
    projects.filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.slug.includes(needle)),
    sort,
    dir,
  );
  const maxRequests = Math.max(1, ...visible.map((p) => p.totals.requests));
  const withTraffic = projects.filter((p) => p.totals.requests > 0).length;
  const withServices = projects.filter((p) => p.services > 0).length;
  const total = projects.reduce((n, p) => n + p.totals.requests, 0);

  // Monta a URL mantendo o resto do estado da página.
  const href = (change: Partial<Record<"period" | "sort" | "dir" | "q", string>>) => {
    const params = new URLSearchParams();
    const state = { period: period.key as string, sort, dir, q: filter, ...change };
    for (const k of ["period", "sort", "dir", "q"] as const) if (state[k]) params.set(k, state[k]);
    return `/operator/api?${params}`;
  };

  return (
    <section>
      <Link href="/operator" className="text-sm text-muted hover:underline">
        ← SCF overview
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">API analytics across projects</h1>
      <p className="mt-2 text-muted">
        Active projects only. Each project adds up its API services. Errors are the share of requests; latency is
        across all requests of the project. All times in UTC.
      </p>

      <PeriodPicker current={period.key} href={(key: PeriodKey) => href({ period: key })} />

      <p className="mt-4 text-sm text-muted">
        {formatCount(total)} requests in total. {withTraffic} of {projects.length} active project
        {projects.length === 1 ? "" : "s"} sent API data in this period; {withServices} have at least one API service.
      </p>

      <form method="get" action="/operator/api" className="mt-4 flex flex-wrap items-end gap-3 text-sm" role="search">
        <input type="hidden" name="period" value={period.key} />
        <input type="hidden" name="sort" value={sort} />
        <input type="hidden" name="dir" value={dir} />
        <label className="block min-w-56">
          <span className="font-medium">Filter projects</span>
          <input
            name="q"
            defaultValue={filter}
            maxLength={100}
            placeholder="Name or slug"
            className="mt-1 block w-full rounded-control border border-border-strong bg-transparent px-3 py-2 outline-none focus:border-accent"
          />
        </label>
        <button type="submit" className="rounded-control border border-border-strong px-3 py-2 hover:bg-surface-2">
          Apply
        </button>
        {filter && (
          <Link href={href({ q: "" })} className="py-2 text-muted hover:underline">
            Clear
          </Link>
        )}
      </form>

      <div className={`${cardClass} mt-6 overflow-x-auto px-4 py-1`}>
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-border text-muted">
            <tr>
              {(Object.keys(SORTS) as SortKey[]).map((key) => {
                const active = key === sort;
                const nextDir = active ? (dir === "asc" ? "desc" : "asc") : key === "name" ? "asc" : "desc";
                return (
                  <th
                    key={key}
                    aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}
                    className={`py-2 font-medium ${key === "name" ? "" : "pl-3 text-right"}`}
                  >
                    <Link href={href({ sort: key, dir: nextDir })} className={`hover:underline ${active ? "text-fg" : ""}`}>
                      {SORTS[key].label}
                      {active && <span aria-hidden>{dir === "asc" ? " ↑" : " ↓"}</span>}
                    </Link>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="py-3 text-muted">
                  {filter ? "No active project matches this filter." : "No active projects yet."}
                </td>
              </tr>
            )}
            {visible.map((p) => (
              <tr key={p.tenantId}>
                <td className="py-2 align-top">
                  <Link href={`/operator/tenants/${p.tenantId}`} className="font-medium hover:underline">
                    {p.name}
                  </Link>
                  <span className="ml-2 font-mono text-xs text-muted">{p.slug}</span>
                </td>
                <td className="py-2 pl-3 text-right align-top tabular-nums">{p.services}</td>
                {p.totals.requests === 0 ? (
                  <td colSpan={5} className="py-2 pl-3 text-right align-top text-muted">
                    {p.services === 0 ? "No API services" : "No requests in this period"}
                  </td>
                ) : (
                  <>
                    <td className="py-2 pl-3 text-right align-top tabular-nums">
                      {formatCount(p.totals.requests)}
                      <div className="mt-1 flex justify-end" aria-hidden>
                        <div
                          className="h-1 rounded-l-[4px] bg-series"
                          style={{ width: `${(p.totals.requests / maxRequests) * 6}rem` }}
                        />
                      </div>
                    </td>
                    <td
                      className={`py-2 pl-3 text-right align-top tabular-nums ${
                        p.totals.requests > 0 && p.totals.serverErrors / p.totals.requests > 0.01 ? "font-semibold text-bad" : ""
                      }`}
                    >
                      {p.totals.requests > 0 && p.totals.serverErrors / p.totals.requests > 0.01 && (
                        <Icon name="alert" className="mr-1 inline size-3.5 align-[-2px]" />
                      )}
                      {formatShare(p.totals.serverErrors, p.totals.requests)}
                    </td>
                    <td className="py-2 pl-3 text-right align-top tabular-nums">
                      {formatShare(p.totals.clientErrors, p.totals.requests)}
                    </td>
                    <td className="whitespace-nowrap py-2 pl-3 text-right align-top tabular-nums">{formatLatency(p.totals.p50)}</td>
                    <td className="whitespace-nowrap py-2 pl-3 text-right align-top tabular-nums">{formatLatency(p.totals.p95)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted">
        Sort by requests, ascending, to find projects that barely use their API services.
      </p>
    </section>
  );
}
