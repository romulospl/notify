import "server-only";
import type { TenantContext, TenantReadContext } from "../access";
import type { Period } from "../period";
import { getSite } from "../data/sites";
import {
  type Breakdown,
  BREAKDOWNS,
  type Point,
  readBreakdown,
  readEvents,
  readEventValues,
  readSeries,
  readStats,
  type SiteStats,
  type Totals,
} from "./read";

// The pages handle the Umami failure without importing the HTTP client (lint rule).
export { UmamiError } from "./http";
export type { Breakdown, SiteStats, Totals };

// Web statistics read. Takes the portal's site ID, never Umami's: the Umami
// ID is only obtained after checking that the site belongs to the context's
// tenant (ADR 0003). Another tenant's site returns null without calling Umami.

export async function getSiteStats(
  ctx: TenantContext,
  siteId: string,
  range: { startAt: Date; endAt: Date },
): Promise<SiteStats | null> {
  const found = await getSite(ctx, siteId);
  if (!found) return null;
  return readStats(found.umamiWebsiteId, range);
}

// Tenant web dashboard (#28): the 7 minimum metrics of a site in a period.
// Checked on Umami 3.4.1 (open item of ADR 0001):
// - /stats: pageviews, visitors, visits, bounces and total time, with the
//   previous period of the same size in `comparison`;
// - /metrics?type=referrer|country|device|browser: sorted lists in which `y`
//   counts visitors (unique sessions), not pageviews;
// - /pageviews: series per hour, day or month, only with the buckets that have data.

export const TOP_LIMIT = 10;

// Custom events and wallets (#50, ADR 0015). The event list is read with room
// to spare (EVENT_FETCH_LIMIT names) so disconnections are found even outside
// the top 10; the dashboard shows only TOP_LIMIT.
export const EVENT_FETCH_LIMIT = 100;
export const WALLET_SELECTED = "wallet_selected";
export const WALLET_DISCONNECTED = "wallet_disconnected";

export type RankedItem = { name: string; visitors: number };
export type CountedItem = { name: string; count: number };

export type SiteDashboard = {
  totals: Totals;
  previous: Totals;
  // One point per bucket of the period, including the empty ones.
  series: { at: Date; pageviews: number; visitors: number }[];
  breakdowns: Record<Breakdown, RankedItem[]>;
  // Custom events by name, counted in events.
  events: CountedItem[];
  // Wallets Kit adapter events (script v1.3.0+): selections per wallet module
  // id and the total of disconnections.
  wallets: { selections: CountedItem[]; disconnects: number };
};

// Null when the site does not belong to the context's tenant (or is archived):
// in that case no call reaches Umami.
export async function getSiteDashboard(
  ctx: TenantReadContext,
  siteId: string,
  period: Period,
): Promise<SiteDashboard | null> {
  const found = await getSite(ctx, siteId);
  if (!found) return null;
  const id = found.umamiWebsiteId;
  const [stats, series, events, walletValues, ...lists] = await Promise.all([
    readStats(id, period),
    readSeries(id, period),
    readEvents(id, period, EVENT_FETCH_LIMIT),
    readEventValues(id, period, WALLET_SELECTED, "wallet"),
    ...BREAKDOWNS.map((type) => readBreakdown(id, type, period, TOP_LIMIT)),
  ]);
  const eventCounts = events.map((p) => ({ name: p.x ?? "", count: Number(p.y) }));

  const byTime = (points: Point[]) => new Map(points.map((p) => [Date.parse(p.x ?? ""), Number(p.y)]));
  const pageviews = byTime(series.pageviews);
  const sessions = byTime(series.sessions);
  const { comparison, ...totals } = stats;

  return {
    totals,
    previous: comparison,
    series: period.buckets.map((at) => ({
      at,
      pageviews: pageviews.get(at.getTime()) ?? 0,
      visitors: sessions.get(at.getTime()) ?? 0,
    })),
    breakdowns: Object.fromEntries(
      BREAKDOWNS.map((type, i) => [
        type,
        lists[i]!.map((p) => ({ name: p.x ?? "", visitors: Number(p.y) })),
      ]),
    ) as Record<Breakdown, RankedItem[]>,
    events: eventCounts.slice(0, TOP_LIMIT),
    wallets: {
      selections: walletValues.slice(0, TOP_LIMIT).map((v) => ({ name: v.value, count: Number(v.total) })),
      disconnects: eventCounts.find((e) => e.name === WALLET_DISCONNECTED)?.count ?? 0,
    },
  };
}
