import "server-only";
import type { OperatorContext } from "../access";
import { type ActiveTenantSites, listActiveTenantSites } from "../data/operator/sites";
import type { Period } from "../period";
import { type Breakdown, BREAKDOWNS, readBreakdown, readStats, type Totals } from "./read";
import type { RankedItem } from "./stats";

// Painel web global do SCF (#29): as métricas de todos os projetos ativos e a
// comparação lado a lado de alguns deles. Só o operador chama (OperatorContext).
//
// Os IDs do Umami vêm sempre de listActiveTenantSites, nunca da URL: um
// tenantId desconhecido, removido ou pendente é descartado antes de qualquer
// chamada. Projeto com vários sites soma os sites (visitantes também: o Umami
// conta sessões por site).
//
// Custo: a tabela faz uma chamada (/stats) por site e a comparação, 5 por site
// dos projetos escolhidos. Todas passam pelo mesmo limitador, que conta
// chamadas HTTP (não sites): no máximo MAX_PARALLEL leituras dos painéis
// globais ao mesmo tempo no processo, somando a tabela, a comparação e outros
// operadores abrindo a página. Para os pilotos isso basta; com centenas de
// sites, ler o banco do Umami direto ou guardar um resumo muda o ADR 0002 e
// vira ADR novo.

export const MAX_PARALLEL = 8;
export const COMPARE_MIN = 2;
export const COMPARE_MAX = 4;
export const COMPARE_TOP = 5;
// Cada site contribui com as 10 primeiras linhas de cada lista; a soma entre
// sites é uma aproximação quando um item fica fora do top 10 de algum site.
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

// Semáforo: no máximo `limit` chamadas em andamento. Uma vaga só é liberada
// quando a chamada termina (com sucesso ou erro), então uma falha rápida não
// abre espaço para mais chamadas do que o limite.
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
  // Nulo quando algum site do projeto não respondeu: o projeto aparece como
  // indisponível, em vez de com números parciais.
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
  const projects = await listActiveTenantSites(ctx);
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
    // Só a contagem: o log não leva ID de site nem detalhe do Umami.
    console.error("Painel global: sites sem resposta do Umami", failed.length);
  }
  return { projects: rows, unavailable: rows.filter((r) => r.totals === null).length };
}

export type ProjectComparison = ProjectWebStats & { breakdowns: Record<Breakdown, RankedItem[]> | null };

// IDs pedidos na URL que são de projetos ativos, sem repetição, na ordem pedida.
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

// Comparação lado a lado: as 7 métricas de 2 a 4 projetos ativos. IDs
// desconhecidos são descartados; com menos de COMPARE_MIN válidos, devolve
// nulo e nada chega ao Umami.
export async function compareProjects(
  ctx: OperatorContext,
  requested: string[],
  period: Period,
): Promise<ProjectComparison[] | null> {
  const projects = await listActiveTenantSites(ctx);
  const ids = pickComparable(projects, requested);
  if (ids.length < COMPARE_MIN) return null;
  const chosen = ids.map((id) => projects.find((p) => p.tenantId === id)!);

  // Cada site faz 5 chamadas, todas pelo limitador comum.
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
